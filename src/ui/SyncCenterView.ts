import { App, ButtonComponent, ExtraButtonComponent, ItemView, Modal, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { ApplyItem, CaptureItem, ProgressFn, StateAction } from "../core/ConfigSyncCore";
import { bucketCounts, GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry } from "../core/status";
import { CATEGORY_LABELS, findGroupByName, ItemCategory, SELF_GROUP_NAME, categoryForGroup } from "../core/catalog";
import { FileChanges, GroupResult, Remote, SyncGroup, hasChanges } from "../core/types";
import { Availability } from "../core/availability";
import {
  capFileEntries,
  CappedEntry,
  defaultPolicy,
  footerSummary,
  insyncLineText,
  isValidPolicy,
  matchesSearch,
  moreFilesText,
  nosettingsLineText,
  PanelFilter,
  policyOptions,
  presentedState,
  runProgressLabel,
  SECTION_NOTES,
  SECTION_TITLES,
  SectionKind,
  sectionForItem,
  stageableRow,
  versionLine,
  visibleUnderFilter,
  Direction,
  effectiveDirection,
} from "./panelModel";
import { renderDiffPanel } from "./diffView";
import { SWITCH_LIST_GROUPS, switchListSortedView } from "../core/switchList";
import { renderReportContent, renderReportPills } from "./reportContent";
import { RunRecord, RunKind, RunStatus, worstStatus, formatRunTime, stopSyncDesc, deleteLeftoverDesc } from "../core/runHistory";
import { ACTION_ICON, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";

// Sidebar scope order: Beta sits between Community and custom (batch 3 ③).
const SCOPE_ORDER: (ItemCategory | "beta")[] = ["obsidian", "core", "community", "beta", "custom"];
const SCOPE_LABELS: Record<ItemCategory | "beta", string> = { ...CATEGORY_LABELS, beta: "Beta" };
const STATUS_CLS: Record<RunStatus, string> = { ok: "is-ok", warning: "is-warn", error: "is-error" };

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
  contentChanged: boolean; // config-sync's own data.json differs beyond the list → pane shows a diff
  versionRefresh: { local: string; store: string } | null; // content in-sync but plugin version ahead
  flagsRefresh: number | null; // installed plugins whose desktopOnly flag isn't recorded yet → nudge a capture
}

export interface SyncCenterHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
  selfStatus(): Promise<SelfSyncInfo>;
  resolvedPath(group: SyncGroup): string;
  displayName(group: string, storedLabel?: string): string;
  captureItems(items: CaptureItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  applyItems(items: ApplyItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  reloadApp(): void;
  remotes(): Remote[]; // [] on mobile
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  deepDiff(remote: Remote): Promise<{ entries: RemoteDiffEntry[]; lockDiffers: boolean }>;
  pullFrom(remote: Remote): Promise<GroupResult[] | null>;
  pushTo(remote: Remote): Promise<GroupResult[] | null>;
  bootstrapOffer(): Promise<{ itemCount: number; capturedAt: string | null } | null>;
  dismissBootstrap(): void;
  adoptConfiguration(): Promise<GroupResult[] | null>;
  switchLocalDecisions(name: string): string[]; // [] for non-switch-list groups
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
  // side is missing or unparseable.
  switchDivergenceFor(name: string): Promise<{ captureRemoves: string[]; applyDisables: string[] } | null>;
  addSwitchExceptions(name: string, ids: string[]): Promise<void>;
  // Contents for an inline change diff: base = current state of the target side, produced =
  // what the pending action (capture/apply) would write. null = no diff available.
  diffPair(name: string, rel: string, dir: Direction): Promise<{ base: string; produced: string } | null>;
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

// Fields-mode badge (定稿方案 B 2026-07-17): three field lines with a small padlock at the
// bottom-right corner — "some fields are locked". No Lucide icon carries this composite.
function drawFieldsBadge(el: HTMLElement): void {
  const svg = el.createSvg("svg", {
    attr: {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
  });
  svg.createSvg("path", { attr: { d: "M3 5h18M3 11h9M3 17h7" } });
  svg.createSvg("rect", { attr: { x: "14.5", y: "14.5", width: "8", height: "6.5", rx: "1.4", "stroke-width": "1.8" } });
  svg.createSvg("path", { attr: { d: "M16.5 14.5v-2a2 2 0 0 1 4 0v2", "stroke-width": "1.8" } });
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
  private policy = sessionStaging.policy;
  private sectionOpen: Set<SectionKind> = new Set();
  private selected = sessionStaging.selected;
  private directionOverride = sessionStaging.directionOverride;
  private expandedItems: Set<string> = new Set();
  private renderGen = 0;
  private filter: PanelFilter = "all";
  private panelScope: { kind: "device"; cat: ItemCategory | "beta" | "all" } | { kind: "remote"; name: string } | { kind: "history" } | { kind: "self" } = { kind: "device", cat: "all" };
  private selfInfo: SelfSyncInfo | null = null;
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
    this.selfInfo = await this.host.selfStatus();
    // Fresh device: open straight to the Config Sync pane (the adopt entry) instead of an empty
    // item list — once. After that the user navigates freely.
    if (!this.landedInitial) {
      this.landedInitial = true;
      if (this.selfInfo.state === "coldstart") this.panelScope = { kind: "self" };
    }
    this.history = this.host.runHistoryEnabled() ? await this.host.loadRunHistory() : [];
    // Leftover means "store files with no matching group"; a device with no groups (fresh /
    // pre-adopt) has no baseline, so the whole store would look leftover — dangerous with
    // "Delete all". Only compute it once the manifest exists.
    this.leftovers = this.groups.length > 0 ? await this.host.listLeftoverStoreFiles() : [];
    if (this.filter === "leftover" && this.leftovers.length === 0) this.filter = "all"; // orphans all cleared
    // User state survives reloads; prune entries whose item vanished.
    const names = new Set(groups.map((g) => g.name));
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
    // Default pre-check seeds once per Obsidian session, never on later refreshes or
    // view recreations (mobile recreates the view on tab switches).
    if (!sessionStaging.seeded) {
      sessionStaging.seeded = true;
      for (const s of statuses) {
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

  private rows(): StatusRow[] {
    const out: StatusRow[] = [];
    for (const group of this.groups) {
      // config-sync manages itself in its own sidebar destination (renderConfigSyncMode), so it
      // never appears in the item list, scopes, filter pills, or footer totals — all of which
      // derive from this row set.
      if (group.name === SELF_GROUP_NAME) continue;
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    // The store manifest accretes in capture order; the view sorts deterministically —
    // scope rank, then display name — so e.g. core items never interleave the Obsidian
    // ones (batch 3 ④).
    out.sort((a, b) => {
      const rank = SCOPE_ORDER.indexOf(this.scopeOf(a.group.name)) - SCOPE_ORDER.indexOf(this.scopeOf(b.group.name));
      if (rank !== 0) return rank;
      return this.host.displayName(a.group.name, a.group.label).localeCompare(this.host.displayName(b.group.name, b.group.label));
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

  // Section-aware stageability: action-only rows (install-only / enable-only / update-only)
  // stage in their sections. The self plugin is exempt from update-only — updating it from
  // inside a run would unload the code executing the run.
  private rowStageable(r: StatusRow): boolean {
    const section = this.sectionOf(r.group.name);
    if (r.group.name === SELF_GROUP_NAME && section === "outdated" && this.presState(r) === "in-sync") return false;
    return stageableRow(this.presState(r), section);
  }

  // All user-facing counts (header pills, sidebar badges, filter pills, switcher) must agree
  // with what the filters actually show — i.e. count PRESENTED states, not raw ones.
  private presentedCounts(rows: StatusRow[]): ReturnType<typeof bucketCounts> {
    return bucketCounts(rows.map((r) => ({ ...r.status, state: this.presState(r) })));
  }

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    this.contentEl.empty();
    this.renderHeader();
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "config-sync-main" });
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
    const item = container.createDiv({ cls: `config-sync-side-item config-sync-side-self${active ? " is-active" : ""}` });
    item.createSpan({ cls: "config-sync-side-self-ic", text: "⚙" });
    item.createSpan({ cls: "config-sync-side-name", text: "Config Sync" });
    if (info !== null) {
      const b = this.selfBadge(info);
      if (b !== null) {
        const badge = item.createSpan({ cls: `config-sync-side-badge ${b.cls}` });
        if (b.action !== undefined) renderActionCount(badge, b.action, b.count ?? 0);
        else badge.setText(b.text ?? "");
      }
    }
    item.addEventListener("click", () => {
      this.panelScope = { kind: "self" };
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
  }

  private selfBadge(info: SelfSyncInfo): { cls: string; action?: SyncAction; count?: number; text?: string } | null {
    // Count the sync-list delta; when the change is config-sync's own content/version (no list
    // delta), show a bare icon rather than a misleading "↑0"/"↓0".
    const n = info.delta.added.length + info.delta.removed.length;
    switch (info.state) {
      case "coldstart":
        return { cls: "is-down", text: "setup" };
      case "adopt":
        return { cls: "is-down", action: "apply", count: n };
      case "capture":
        return { cls: "is-up", action: "capture", count: n };
      case "both":
        return { cls: "is-up", text: "⚠" };
      case "insync":
        return null;
    }
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
        return { text: "in sync", cls: "is-ok" };
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

  private renderSelfConfigSummary(pane: HTMLElement): void {
    const block = pane.createDiv({ cls: "config-sync-self-block" });
    block.createDiv({ cls: "config-sync-self-block-h", text: "This device's configuration" });
    const link = block.createDiv({ cls: "config-sync-self-link", text: "Open Config Sync settings →" });
    link.addEventListener("click", () => {
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById("config-sync");
    });
  }

  // The Config Sync pane: the self layer's bidirectional adopt/capture surface (S0–S4).
  private renderConfigSyncMode(main: HTMLElement): void {
    const info = this.selfInfo;
    if (info === null) return;
    const pane = main.createDiv({ cls: "config-sync-self-pane" });
    const title = pane.createDiv({ cls: "config-sync-self-title" });
    title.createSpan({ cls: "config-sync-self-title-ic", text: info.state === "coldstart" ? "⬇" : info.state === "capture" ? "⇧" : info.state === "both" ? "⚠" : "⚙" });
    title.createSpan({ text: "Config Sync" });
    const pill = this.selfStatePill(info);
    if (pill !== null) title.createSpan({ cls: `config-sync-self-pill ${pill.cls}`, text: pill.text });

    if (info.state === "coldstart") {
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
          this.filter = "apply";
          this.panelScope = { kind: "device", cat: "all" };
          this.render(this.renderGen);
        });
      }
      this.renderSelfConfigSummary(pane);
      return;
    }

    const sub = pane.createDiv({ cls: "config-sync-self-sub" });
    if (info.state === "both") sub.setText("Both your list and the store changed. Adopt first, then capture — capturing now would overwrite another device's list additions with this device's older list.");
    else if (info.state === "adopt") sub.setText("The list of what this device syncs changed in the store. Adopt to bring the new items onto this device; they then appear under the item scopes as normal, apply-able rows.");
    else sub.setText("You changed what this device syncs. Capture to publish it to the store, so your other devices can adopt it.");

    if (info.state === "adopt" || info.state === "both") {
      const block = pane.createDiv({ cls: "config-sync-self-block is-act" });
      block.createDiv({ cls: "config-sync-self-block-h", text: info.state === "both" ? "① Adopt updates from the store first" : "Updates from the store" });
      if (info.state === "adopt") block.createDiv({ cls: "config-sync-self-block-s", text: "Adopting adds these to this device's sync list — it does not apply their settings; you still choose that per item afterward." });
      if (info.delta.added.length > 0 || info.delta.removed.length > 0) this.renderSelfDelta(block, info.delta.added, info.delta.removed);
      else this.renderSelfContentDetail(block, info, "apply"); // store's config-sync settings changed, not the list
      const acts = block.createDiv({ cls: "config-sync-self-acts" });
      const adopt = acts.createEl("button", { cls: "mod-cta", text: "Adopt all" });
      adopt.addEventListener("click", () => this.runSelfAdopt(adopt));
    }

    if (info.state === "capture" || info.state === "both") {
      const gated = info.state === "both";
      const block = pane.createDiv({ cls: `config-sync-self-block${gated ? " is-gated" : ""}` });
      block.createDiv({ cls: "config-sync-self-block-h", text: gated ? "② Then capture your local change" : "Local changes not yet in the store" });
      if (info.delta.removed.length > 0) this.renderSelfDelta(block, info.delta.removed, []); // your local-only groups
      else this.renderSelfContentDetail(block, info, "capture"); // config-sync's own settings/version changed, not the list
      const acts = block.createDiv({ cls: "config-sync-self-acts" });
      const cap = acts.createEl("button", { cls: "config-sync-btn-capture", text: "Capture" });
      if (gated) {
        cap.disabled = true;
        acts.createSpan({ cls: "config-sync-self-hint", text: "— available after adopting" });
      } else {
        cap.addEventListener("click", () => this.runSelfCapture(cap));
      }
    }

    this.renderSelfConfigSummary(pane);
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
    const holder = block.createDiv({ cls: "config-sync-inline-diff" });
    void this.host.diffPair(SELF_GROUP_NAME, "", dir).then((pair) => {
      if (pair === null) {
        holder.createDiv({ cls: "config-sync-expand-note", text: "no diff available" });
        return;
      }
      const leftLabel = dir === "capture" ? "store" : "this device";
      const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
      renderDiffPanel(holder, pair.base, pair.produced, leftLabel, rightLabel, "data.json");
    });
  }

  private renderSidebar(shell: HTMLElement): void {
    const side = shell.createDiv({ cls: "config-sync-side" });
    const searchEl = side.createEl("input", {
      type: "search",
      cls: "config-sync-side-search",
      attr: { placeholder: "Filter by name…" },
    });
    searchEl.value = this.search;
    if (this.panelScope.kind === "remote") searchEl.disabled = true;
    searchEl.addEventListener("input", () => {
      const wasSearching = this.searching();
      this.search = searchEl.value;
      if (!wasSearching && this.searching()) this.filter = "all"; // searching means "find this item"
      this.render(this.renderGen); // full render: badges, sections, list all react
      const refocus = this.contentEl.querySelector<HTMLInputElement>(".config-sync-side-search");
      if (refocus !== null) {
        refocus.focus();
        const v = refocus.value;
        refocus.value = "";
        refocus.value = v;
      }
    });
    this.renderScopeEntries(side);
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
        const hits = scopeRows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search)).length;
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
      for (const remote of remotes) {
        const active = this.panelScope.kind === "remote" && this.panelScope.name === remote.name;
        const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
        item.createSpan({ cls: "config-sync-side-name", text: remote.name });
        const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
        this.paintStateIcon(item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } }), icon);
        item.addEventListener("click", () => {
          this.panelScope = { kind: "remote", name: remote.name };
          this.switcherOpen = false;
          this.render(this.renderGen);
        });
      }
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
      sw.createSpan({ text: "⚙ Config Sync" });
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

  private renderHeader(): void {
    // No title span: the pane header already reads "Sync Center" (mobile polish round 2).
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    const { up, down, ok, none } = this.presentedCounts(this.mainRows());
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
    // Manual refresh (定稿 2026-07-17, replaces the enabled-set polling): same affordance as
    // the Remotes ↻ — re-scans local state, catching plugin toggles made in Obsidian's
    // settings modal while the panel stayed open.
    const refresh = new ExtraButtonComponent(head);
    refresh.setIcon("refresh-cw");
    refresh.setTooltip("Refresh local state");
    refresh.extraSettingsEl.addClass("config-sync-center-refresh");
    refresh.onClick(() => void this.reload());
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
    const close = head.createSpan({ cls: "config-sync-strip-close", text: "✕" });
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
  private actionCell(rec: RunRecord): { glyph: string; dir: "in" | "out" | "remove"; label: string } {
    if (rec.kind === "stop-sync") return { glyph: "⊘", dir: "remove", label: "Stop syncing" };
    if (rec.kind === "delete-leftover") return { glyph: "⌫", dir: "remove", label: "Delete leftover" };
    const out = rec.kind === "capture" || rec.kind === "push";
    const base = rec.kind.charAt(0).toUpperCase() + rec.kind.slice(1);
    const label = rec.remote !== null ? `${base} · ${rec.remote}` : base;
    return { glyph: out ? "↑" : "↓", dir: out ? "out" : "in", label };
  }

  private renderHistoryMode(main: HTMLElement): void {
    const open = this.historyOpen !== null ? this.history[this.historyOpen] : undefined;
    if (open !== undefined) {
      this.renderHistoryDetail(main, open);
      return;
    }
    this.historyOpen = null;
    this.renderHistoryTable(main);
  }

  private renderHistoryTable(main: HTMLElement): void {
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
    if (this.history.length === 0) {
      main.createDiv({ cls: "config-sync-hempty", text: "No runs recorded yet." });
      return;
    }
    const legend = main.createDiv({ cls: "config-sync-hlegend" });
    const leg = (cls: string, glyph: string, text: string): void => {
      const s = legend.createSpan();
      s.createSpan({ cls: `config-sync-hstat ${cls}`, text: glyph });
      s.appendText(` ${text}`);
    };
    leg("is-ok", "✓", "Done"); leg("is-warn", "⚠", "Action needed"); leg("is-error", "✗", "Failed");

    const table = main.createEl("table", { cls: "config-sync-htable" });
    const thead = table.createEl("thead").createEl("tr");
    for (const h of ["", "When", "Action", "Changed", "Issues", "Summary", ""]) thead.createEl("th", { text: h });
    const body = table.createEl("tbody");
    this.history.forEach((rec, i) => {
      const tr = body.createEl("tr", { cls: "config-sync-hrow" });
      const st = this.statusTip(rec.status);
      tr.createEl("td", { cls: "config-sync-htd-st" }).createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status), attr: { "aria-label": st } });
      tr.createEl("td", { cls: "config-sync-htd-when", text: formatRunTime(rec.at) });
      const act = this.actionCell(rec);
      const td = tr.createEl("td", { cls: "config-sync-htd-act" });
      td.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
      td.appendText(` ${act.label}`);
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

  private scopedRows(): StatusRow[] {
    if (this.searching()) return this.rows();
    if (this.panelScope.kind !== "device" || this.panelScope.cat === "all") return this.rows();
    const cat = this.panelScope.cat;
    return this.rows().filter((r) => this.scopeOf(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    this.renderResultStrip(main);
    const scoped = this.scopedRows();
    const mainRows = scoped.filter((r) => this.sectionOf(r.group.name) === "main");
    const sections: Record<Exclude<SectionKind, "main">, StatusRow[]> = { outdated: [], disabled: [], "not-installed": [], "desktop-only": [] };
    for (const r of scoped) {
      const s = this.sectionOf(r.group.name);
      if (s !== "main") sections[s].push(r);
    }
    const bar = main.createDiv({ cls: "config-sync-mainbar" });
    const pillRow = bar.createDiv({ cls: "config-sync-fpillrow" });
    let searchEl: HTMLInputElement | null = null;
    if (this.compact) {
      searchEl = bar.createEl("input", {
        type: "search",
        cls: "config-sync-mainbar-search",
        attr: { placeholder: "Filter by name…" },
      });
      searchEl.value = this.search;
    }
    const selectAll = bar.createEl("input", { type: "checkbox", cls: "config-sync-selectall", attr: { "aria-label": "Select all visible items" } });
    const listHost = main.createDiv();
    const sectionsHost = main.createDiv();

    // Pills recompute from the live search term. While searching, they count the MATCHED
    // set (定稿): the All pill keeps the unfiltered total as "n / m".
    const renderPills = (): void => {
      pillRow.empty();
      const pillRows = this.searching()
        ? mainRows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search))
        : mainRows;
      const counts = this.presentedCounts(pillRows);
      // Mobile shows the short glyph form (定稿 B) — the panel's icon language (↑ ↓ ✓ ○) —
      // so all five pills always fit one line; desktop keeps the full labels.
      const allLabel = this.searching() ? `All ${pillRows.length} / ${mainRows.length}` : `All ${mainRows.length}`;
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
          this.filter = d.key;
          this.render(this.renderGen);
        });
      }
      // Leftover store files: an amber pill in the All-items scope, only when there are any.
      if (this.panelScope.kind === "device" && this.panelScope.cat === "all" && this.leftovers.length > 0) {
        const pill = pillRow.createEl("button", { cls: `config-sync-fpill is-leftover${this.filter === "leftover" ? " is-active" : ""}` });
        pill.createSpan({ cls: "config-sync-fpill-long", text: `Leftover ${this.leftovers.length}` });
        pill.createSpan({ cls: "config-sync-fpill-short", text: `⌫ ${this.leftovers.length}` });
        pill.addEventListener("click", () => {
          this.filter = "leftover";
          this.render(this.renderGen);
        });
      }
    };
    const renderSections = (): void => {
      sectionsHost.empty();
      if (this.filter === "leftover") return; // the leftover view owns the whole main area
      this.renderSection(sectionsHost, "outdated", sections.outdated);
      this.renderSection(sectionsHost, "disabled", sections.disabled);
      this.renderSection(sectionsHost, "not-installed", sections["not-installed"]);
      this.renderInfoSection(sectionsHost, "desktop-only", sections["desktop-only"]);
    };

    renderPills();
    this.renderListInto(listHost, mainRows);
    this.wireGlobalSelectAll(selectAll, mainRows);
    renderSections();

    // The compact search co-renders everything except its own input element, so the soft
    // keyboard stays open while pills, list, sections and select-all track the search.
    if (searchEl !== null) {
      const input = searchEl;
      input.addEventListener("input", () => {
        const wasSearching = this.searching();
        this.search = input.value;
        // Entering a search resets the direction filter: searching means "find this item",
        // and a leftover ↑/↓/✓/○ filter would silently hide the matches.
        if (!wasSearching && this.searching()) this.filter = "all";
        renderPills();
        this.renderListInto(listHost, mainRows);
        this.refreshGlobalSelectAll(selectAll, mainRows);
        renderSections();
      });
    }

    this.renderActionBar(main);
  }

  private visibleRows(scoped: StatusRow[]): StatusRow[] {
    return scoped.filter((r) => visibleUnderFilter(this.presState(r), this.filter) && matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search));
  }

  private renderListInto(listHost: HTMLElement, scoped: StatusRow[]): void {
    listHost.empty();
    if (this.filter === "leftover") {
      this.renderLeftoverSection(listHost);
      return;
    }
    const searching = this.search.trim() !== "";
    const visible = this.visibleRows(scoped);
    if (searching) {
      // Search keeps context (定稿): the main card gets a labeled head with hit counts,
      // mirroring the sections' "n of m".
      const head = listHost.createDiv({ cls: "config-sync-section-head is-plain" });
      head.createSpan({ cls: "config-sync-section-title", text: "All items" });
      head.createSpan({ cls: "config-sync-pill is-neutral", text: `${visible.length} of ${scoped.length}` });
    }
    const card = listHost.createDiv({ cls: "config-sync-card" });
    if (this.filter === "all" && !searching) {
      const active = visible.filter((r) => this.presState(r) !== "in-sync" && this.presState(r) !== "no-settings");
      const insync = visible.filter((r) => this.presState(r) === "in-sync");
      const nosettings = visible.filter((r) => this.presState(r) === "no-settings");
      this.renderRowList(card, active);
      this.renderTrailingLine(card, insync, sessionUi.insyncOpen, (n, open) => insyncLineText(n, open));
      this.renderTrailingLine(card, nosettings, sessionUi.nosettingsOpen, (n, open) => nosettingsLineText(n, open));
    } else {
      this.renderRowList(card, visible);
    }
  }

  // All-items scope groups its rows under scope headers (定稿 A); single-scope views stay
  // flat — the scope itself is the title (定稿 B).
  private renderRowList(card: HTMLElement, rows: StatusRow[]): void {
    const grouped = this.panelScope.kind === "device" && this.panelScope.cat === "all";
    if (!grouped) {
      for (const r of rows) this.renderItemRow(card, r);
      return;
    }
    for (const cat of SCOPE_ORDER) {
      const inCat = rows.filter((r) => this.scopeOf(r.group.name) === cat);
      if (inCat.length === 0) continue;
      card.createDiv({ cls: "config-sync-sect", text: SCOPE_LABELS[cat] });
      for (const r of inCat) this.renderItemRow(card, r);
    }
  }

  // ✓ / ○ rows fold into one dim line per scope; searching bypasses the fold entirely.
  private renderTrailingLine(card: HTMLElement, rows: StatusRow[], openSet: Set<string>, text: (n: number, open: boolean) => string): void {
    if (rows.length === 0) return;
    const key = this.scopeKey();
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

  // Tri-state select-all over the currently visible checkable rows (scope + filter + search).
  private checkableRows(scoped: StatusRow[]): string[] {
    return this.visibleRows(scoped)
      .filter((r) => this.rowStageable(r))
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

  // A controls-free availability section: no select-all, no per-row checkbox/On-apply — just the
  // items + a note. Used for "Desktop-only" (mobile): those plugins can't run here, so there is
  // nothing to stage or apply; they're shown for awareness only.
  private renderInfoSection(main: HTMLElement, kind: "desktop-only", rows: StatusRow[]): void {
    if (rows.length === 0) return;
    const matches = this.searching()
      ? rows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search))
      : rows;
    if (this.searching() && matches.length === 0) return;
    const open = this.searching() || this.sectionOpen.has(kind);
    const fold = main.createDiv({ cls: `config-sync-section is-${kind}${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "config-sync-section-title", text: SECTION_TITLES[kind] });
    head.createSpan({ cls: "config-sync-pill is-neutral", text: `${matches.length}` });
    head.addEventListener("click", () => {
      if (this.sectionOpen.has(kind)) this.sectionOpen.delete(kind);
      else this.sectionOpen.add(kind);
      this.render(this.renderGen);
    });
    if (!open) return;
    fold.createDiv({ cls: "config-sync-report-legend", text: SECTION_NOTES[kind] });
    for (const r of matches) {
      const row = fold.createDiv({ cls: "config-sync-row is-static" });
      row.createSpan({ cls: "config-sync-rule-name", text: this.host.displayName(r.group.name, r.group.label) });
      row.createSpan({ cls: "config-sync-doto-pill", text: "desktop-only" });
    }
  }

  private renderSection(main: HTMLElement, kind: Exclude<SectionKind, "main">, rows: StatusRow[]): void {
    if (rows.length === 0) return;
    const matches = this.searching()
      ? rows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search))
      : rows;
    if (this.searching() && matches.length === 0) return;
    const open = this.searching() || this.sectionOpen.has(kind);
    const fold = main.createDiv({ cls: `config-sync-section is-${kind}${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "config-sync-section-title", text: SECTION_TITLES[kind] });
    const insync = matches.filter((r) => this.presState(r) === "in-sync");
    const checkable = matches.filter((r) => this.rowStageable(r));
    const countText = this.searching() ? `${matches.length} of ${rows.length}` : `${rows.length - insync.length}`;
    head.createSpan({ cls: "config-sync-pill is-neutral", text: countText });
    if (insync.length > 0) head.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${insync.length}` });
    const staged = checkable.filter((r) => this.selected.has(r.group.name)).length;
    if (staged > 0) head.createSpan({ cls: "config-sync-section-hint", text: `${staged} selected` });
    const box = head.createEl("input", { type: "checkbox", attr: { "aria-label": "Select all in this section" } });
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
          if (!this.policy.has(name)) this.policy.set(name, this.defaultPolicyFor(r));
        } else {
          this.selected.delete(name);
          this.policy.delete(name);
        }
      }
      this.render(this.renderGen);
    });
    head.addEventListener("click", () => {
      if (this.searching()) return; // force-open while searching; header click is a no-op
      if (open) this.sectionOpen.delete(kind);
      else this.sectionOpen.add(kind);
      this.render(this.renderGen);
    });
    if (!open) return;
    fold.createDiv({ cls: "config-sync-section-note", text: SECTION_NOTES[kind] });
    const card = fold.createDiv({ cls: "config-sync-card" });
    for (const r of matches) this.renderItemRow(card, r);
  }

  private renderItemRow(card: HTMLElement, r: StatusRow): void {
    const { group } = r;
    const pres = this.presState(r);
    const inert = !this.rowStageable(r);
    const row = card.createDiv({
      cls: `config-sync-hub-row${inert ? " is-insync" : ""}${pres === "no-settings" ? " is-nosettings" : ""}`,
      attr: { "aria-label": this.host.resolvedPath(group) },
    });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: this.expandedItems.has(group.name) ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: this.host.displayName(group.name, group.label) });
    if (this.availOf(group.name).desktopOnly) row.createSpan({ cls: "config-sync-doto-pill", text: "desktop-only" });
    if (group.mode === "encrypted") {
      const badge = row.createSpan({
        cls: "config-sync-mode-badge",
        attr: { "aria-label": "Encrypted mode — the whole file is stored encrypted" },
      });
      setIcon(badge, "lock");
    } else if (group.mode === "fields") {
      const badge = row.createSpan({
        cls: "config-sync-mode-badge",
        attr: { "aria-label": "Fields mode — only sensitive fields are filtered/encrypted" },
      });
      drawFieldsBadge(badge);
    }
    const ldCount = this.host.switchLocalDecisions(group.name).length;
    if (ldCount > 0) {
      row.createSpan({ cls: "config-sync-ldnote", text: `· ${ldCount} excluded` });
    }
    const chosen = this.policy.get(group.name);
    if (this.selected.has(group.name) && chosen !== undefined) {
      const opt = policyOptions(this.availOf(group.name)).find((o) => o.action === chosen);
      if (opt !== undefined && opt.pill !== null) row.createSpan({ cls: "config-sync-pill is-statenote", text: opt.pill });
    }
    row.createDiv({ cls: "config-sync-rule-spacer" });

    const icon = this.stateIcon(pres);
    const stateEl = row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } });
    // locked pairs the mode badge's lock with a key — "needs the passphrase"; actions show
    // their own icon; the rest stay text glyphs.
    this.paintStateIcon(stateEl, icon);
    if (inert && this.searching() && !this.expandedItems.has(group.name)) {
      // A grey hit must explain itself without a hover (定稿 search UX).
      card.createDiv({ cls: "config-sync-inert-note", text: `${icon.glyph} ${icon.tip}` });
    }

    const dir = this.effDir(r);
    const cb = row.createEl("input", { type: "checkbox" });
    cb.addClass(dir === "capture" ? "is-capture" : "is-apply");
    cb.disabled = inert;
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

    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !this.expandedItems.has(group.name);
    this.renderItemDetail(detail, r);
    // Stop syncing sits inline with the action segment when there is one; otherwise it gets
    // its own footer so every removable item exposes it.
    if (this.canStopSyncing(group.name) && detail.querySelector(".config-sync-segrow") === null) {
      this.renderStopSyncing(detail.createDiv({ cls: "config-sync-stopsync-foot" }), r);
    }
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
    });
  }

  // Paint a state-icon span: an action shows its SVG, locked shows the key SVG, everything
  // else stays a text glyph. The span already carries its `is-*` color class.
  private paintStateIcon(el: HTMLElement, icon: { glyph: string; cls: string; action?: SyncAction }): void {
    if (icon.action !== undefined) setIcon(el, ACTION_ICON[icon.action]);
    else if (icon.cls === "is-locked") setIcon(el, "key-round");
    else el.setText(icon.glyph);
  }

  private stateIcon(state: GroupState): { glyph: string; cls: string; tip: string; action?: SyncAction } {
    switch (state) {
      case "local-changed":
        return { glyph: "↑", cls: "is-up", tip: "changed on this device (likely)", action: "capture" };
      case "store-newer":
        return { glyph: "↓", cls: "is-down", tip: "store is newer (likely)", action: "apply" };
      case "differs":
        return { glyph: "≠", cls: "is-neq", tip: "differs from store — direction unknown" };
      case "not-captured":
        return { glyph: "—", cls: "is-miss", tip: "not yet captured" };
      case "no-settings":
        return { glyph: "○", cls: "is-none", tip: "no settings yet — nothing on this device or in the store" };
      case "locked":
        return { glyph: "🔒", cls: "is-locked", tip: "encrypted — set the passphrase in settings to compare" };
      case "in-sync":
      default:
        return { glyph: "✓", cls: "is-ok", tip: "in sync" };
    }
  }

  // Expanded rows always show content: an error, a state note, or actions + the file diff.
  private renderItemDetail(detail: HTMLElement, r: StatusRow): void {
    const { status } = r;
    // Local decisions surface first (定稿 switch-exceptions.html): the ⌂ rows explain why the
    // item can be in-sync while raw contents differ.
    const excluded = this.host.switchLocalDecisions(r.group.name);
    for (const id of excluded) {
      detail.createDiv({ cls: "config-sync-lddetail", text: `⌂ ${id} — excluded from this list on this device` });
    }
    if (SWITCH_LIST_GROUPS.has(r.group.name)) this.renderSwitchDivergence(detail, r);
    if (status.message !== undefined) {
      detail.createDiv({ cls: "config-sync-status-error", text: status.message });
      return;
    }
    if (status.state === "in-sync") {
      if (this.presState(r) === "local-changed") {
        // Version-ahead with identical content: show the amber version line + why capture helps.
        const line = versionLine(this.availOf(r.group.name));
        if (line !== null) detail.createDiv({ cls: "config-sync-version-line is-amber", text: line.text });
        detail.createDiv({ cls: "config-sync-expand-note", text: "no content changes — capturing refreshes the store version only" });
        return;
      }
      const sec = this.sectionOf(r.group.name);
      if (sec === "disabled") {
        // Unified rule (spec 2026-07-17): settings synced, plugin off — enabling is the payload.
        detail.createDiv({ cls: "config-sync-expand-note", text: "identical to the store — applying just turns the plugin on" });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      if (sec === "not-installed") {
        detail.createDiv({ cls: "config-sync-expand-note", text: `identical to the store — applying installs ${this.installTargetText(r.group.name)}` });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      if (sec === "outdated") {
        if (r.group.name === SELF_GROUP_NAME) {
          detail.createDiv({
            cls: "config-sync-expand-note",
            text: "Config Sync updates itself through Obsidian's plugin updater — Settings → Community plugins.",
          });
          return;
        }
        // Update-only (spec 2026-07-17): settings match, the plugin is behind — the update
        // action is the whole payload.
        const line = versionLine(this.availOf(r.group.name));
        if (line !== null) detail.createDiv({ cls: `config-sync-version-line${line.tone === "amber" ? " is-amber" : ""}`, text: line.text });
        detail.createDiv({ cls: "config-sync-expand-note", text: "no content changes — updates the plugin only" });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: excluded.length > 0 ? "in sync — excluded plugins are not compared" : "identical to the store",
      });
      return;
    }
    if (status.state === "no-settings") {
      const section = this.sectionOf(r.group.name);
      if (section === "not-installed") {
        // Install-only apply: nothing to write, but the plugin itself can be installed.
        detail.createDiv({ cls: "config-sync-expand-note", text: `no settings to apply — installs ${this.installTargetText(r.group.name)} only` });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      if (section === "disabled") {
        // Enable-only apply (定稿 2026-07-17), symmetric to install-only.
        detail.createDiv({ cls: "config-sync-expand-note", text: "no settings to apply — enables the plugin only" });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      if (section === "outdated") {
        detail.createDiv({ cls: "config-sync-expand-note", text: "no settings anywhere — updates the plugin only" });
        this.renderPolicySeg(detail, r, this.availOf(r.group.name), true);
        return;
      }
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: "no settings yet on this device or in the store — appears under “To capture” once this item has settings",
      });
      return;
    }
    if (status.state === "not-captured") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "not captured yet — nothing in the store" });
      // Disabled-section rows keep the enable choice even here (spec 2026-07-17): capturing
      // Markmind-style local-only settings can also turn the plugin on.
      if (this.sectionOf(r.group.name) === "disabled") this.renderPolicySeg(detail, r, this.availOf(r.group.name), false);
      return;
    }
    if (status.state === "locked") {
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: "encrypted — set the passphrase in Settings → General to compare or apply",
      });
      return;
    }
    if (status.changes === undefined) return;
    const a = this.availOf(r.group.name);
    const line = versionLine(a);
    if (line !== null) detail.createDiv({ cls: `config-sync-version-line${line.tone === "amber" ? " is-amber" : ""}`, text: line.text });
    const section = this.sectionOf(r.group.name);
    if (section === "not-installed") {
      this.renderPolicySeg(detail, r, a, false); // apply-only: no direction toggle
      this.renderCappedChanges(detail, r, status.changes);
      return;
    }
    this.renderDirectionToggle(detail, r);
    // The disabled section offers the enable ladder in BOTH directions (spec 2026-07-17):
    // enabling has no ordering constraint against a capture, it just joins the run.
    if (section === "disabled" || (section !== "main" && this.effDir(r) === "apply")) this.renderPolicySeg(detail, r, a, false);
    this.renderCappedChanges(detail, r, status.changes);
  }

  // Bidirectional divergence summary (定稿 2026-07-17): shown ONLY when both directions
  // would destroy the other side's state — a one-sided difference renders nothing extra.
  private renderSwitchDivergence(detail: HTMLElement, r: StatusRow): void {
    const holder = detail.createDiv();
    void this.host.switchDivergenceFor(r.group.name).then((d) => {
      if (!holder.isConnected || d === null) return;
      if (d.captureRemoves.length === 0 || d.applyDisables.length === 0) return;
      const box = holder.createDiv({ cls: "config-sync-divergence" });
      box.createDiv({ text: "This device and the store diverge both ways — either direction overwrites the other:" });
      box.createDiv({
        cls: "config-sync-divergence-line",
        text: `↑ Capture removes ${d.captureRemoves.length} from the shared list — other devices will turn them off: ${d.captureRemoves.join(", ")}`,
      });
      box.createDiv({
        cls: "config-sync-divergence-line",
        text: `↓ Apply turns off ${d.applyDisables.length} on this device — exclude them first to keep them: ${d.applyDisables.join(", ")}`,
      });
      const btn = holder.createEl("button", {
        cls: "config-sync-seg-btn",
        text: `⌂ Exclude this device's ${d.applyDisables.length} extra${d.applyDisables.length === 1 ? "" : "s"}…`,
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        new ExcludeExtrasModal(this.app, this.host.displayName(r.group.name, r.group.label), d.applyDisables, async (ids) => {
          if (ids.length === 0) return;
          await this.host.addSwitchExceptions(r.group.name, ids);
          await this.reload();
        }).open();
      });
    });
  }

  // Structural groups (the self plugin, the on/off switch lists) are not "items" a user would
  // stop syncing — everything else can be removed from the tracked set.
  private canStopSyncing(name: string): boolean {
    return name !== SELF_GROUP_NAME && !SWITCH_LIST_GROUPS.has(name);
  }

  private renderStopSyncing(container: HTMLElement, r: StatusRow): void {
    const btn = container.createSpan({ cls: "config-sync-stopsync" });
    const svg = btn.createSvg("svg", { attr: { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" } });
    svg.createSvg("circle", { attr: { cx: "12", cy: "12", r: "9" } });
    svg.createSvg("path", { attr: { d: "M6 6l12 12" } });
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

  private renderPolicySeg(detail: HTMLElement, r: StatusRow, a: Availability, installOnly: boolean): void {
    // Install-only rows have no settings payload: "Stage only" would apply nothing at all,
    // so the ladder keeps just the install actions. Capture direction offers only the enable
    // choices — install/update are apply-ordered actions.
    const capturing = this.effDir(r) === "capture";
    const options = policyOptions(a)
      .filter((o) => !installOnly || o.action !== "none")
      .filter((o) => !capturing || o.action === "enable" || o.action === "none");
    if (options.length === 0) return;
    const name = r.group.name;
    detail.createDiv({ cls: "config-sync-seg-label", text: capturing ? "On capture" : "On apply" });
    const segrow = detail.createDiv({ cls: "config-sync-segrow" });
    const seg = segrow.createDiv({ cls: "config-sync-seg" });
    const current = this.policy.get(name) ?? defaultPolicy(a);
    for (const opt of options) {
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-policy${this.selected.has(name) && current === opt.action ? " is-on" : ""}`,
        text: opt.label,
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selected.add(name);
        this.policy.set(name, opt.action);
        this.render(this.renderGen);
      });
    }
    if (this.canStopSyncing(name)) this.renderStopSyncing(segrow, r);
  }

  // Staging, not execution: a segment checks the row in that direction; clicking the
  // active segment unstages it. The footer buttons are the only execution points.
  private renderDirectionToggle(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const staged = this.selected.has(name);
    const dir = this.effDir(r);
    const seg = detail.createDiv({ cls: "config-sync-seg" });
    const segBtn = (d: Direction, label: string, aria: string): void => {
      const on = staged && dir === d;
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-${d}${on ? " is-on" : ""}`,
        attr: { "aria-label": aria },
      });
      renderActionIcon(b, d);
      b.appendText(` ${label}`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (on) {
          this.selected.delete(name);
          this.directionOverride.delete(name);
        } else {
          this.selected.add(name);
          this.directionOverride.set(name, d);
        }
        this.render(this.renderGen);
      });
    };
    segBtn("capture", "Capture", "Capture this (keep local)");
    segBtn("apply", "Apply store", "Apply store version (overwrites local)");
  }

  private renderCappedChanges(detail: HTMLElement, r: StatusRow, changes: FileChanges): void {
    const { shown, rest } = capFileEntries(changes, 10);
    const renderEntry = (e: CappedEntry): void => {
      const line = detail.createDiv({ cls: `is-${e.kind}`, text: `${e.kind === "add" ? "+" : e.kind === "upd" ? "~" : "−"} ${e.name}` });
      if (e.kind === "del") return; // nothing to diff for a pending deletion
      line.addClass("config-sync-diffable");
      const hint = line.createSpan({ cls: "config-sync-diffhint", text: " · diff ▾" });
      let panel: HTMLElement | null = null;
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (panel !== null) {
          panel.remove();
          panel = null;
          hint.setText(" · diff ▾");
          return;
        }
        hint.setText(" · diff ▴");
        const p = createDiv({ cls: "config-sync-inline-diff" });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        void this.host.diffPair(r.group.name, e.name, this.effDir(r)).then((pair) => {
          if (panel !== p) return; // closed while loading
          if (pair === null) {
            p.createDiv({ cls: "config-sync-expand-note", text: "no diff available" });
            return;
          }
          const dir = this.effDir(r);
          const leftLabel = dir === "capture" ? "store" : "this device";
          const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
          // On/off lists compare as sets — sorted view keeps ordering/comma artifacts out.
          const sorted = SWITCH_LIST_GROUPS.has(r.group.name);
          const base = sorted ? switchListSortedView(pair.base) : pair.base;
          const produced = sorted ? switchListSortedView(pair.produced) : pair.produced;
          renderDiffPanel(p, base, produced, leftLabel, rightLabel, sorted ? `${e.name} · sorted view` : e.name);
        });
      });
    };
    for (const e of shown) renderEntry(e);
    if (rest.length > 0) {
      const more = detail.createDiv({ cls: "config-sync-more-files", text: moreFilesText(rest.length) });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        more.remove();
        for (const entry of rest) renderEntry(entry);
      });
    }
  }

  // Capture-direction disabled rows default to ⏻ Enable (spec 2026-07-17); everything else
  // takes the availability ladder's first action.
  private defaultPolicyFor(r: StatusRow): StateAction {
    if (this.sectionOf(r.group.name) === "disabled" && this.effDir(r) === "capture") return "enable";
    return defaultPolicy(this.availOf(r.group.name));
  }

  private capturePayload(): CaptureItem[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.rowStageable(r) && this.effDir(r) === "capture")
      .map((r) => {
        const enable =
          this.sectionOf(r.group.name) === "disabled" && this.policy.get(r.group.name) === "enable";
        return { name: r.group.name, action: enable ? ("enable" as const) : ("none" as const) };
      });
  }

  private applyPayload(): ApplyItem[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.rowStageable(r) && this.effDir(r) === "apply")
      .map((r) => {
        if (this.sectionOf(r.group.name) === "main") return { name: r.group.name, action: "none" as const };
        const a = this.availOf(r.group.name);
        const stored = this.policy.get(r.group.name);
        const action = stored !== undefined && isValidPolicy(a, stored) ? stored : defaultPolicy(a);
        return { name: r.group.name, action };
      });
  }

  private renderActionBar(macro: HTMLElement): void {
    const bar = macro.createDiv({ cls: "config-sync-actionbar" });
    const counted = (r: StatusRow): boolean => this.selected.has(r.group.name) && this.rowStageable(r);
    const mainStaged = this.mainRows().filter(counted).length;
    const outdatedStaged = this.rows().filter((r) => this.sectionOf(r.group.name) === "outdated" && counted(r)).length;
    const disabledStaged = this.rows().filter((r) => this.sectionOf(r.group.name) === "disabled" && counted(r)).length;
    const installStaged = this.rows().filter((r) => this.sectionOf(r.group.name) === "not-installed" && counted(r)).length;
    bar.createSpan({ cls: "config-sync-staged-count", text: footerSummary(mainStaged, outdatedStaged, disabledStaged, installStaged) });
    bar.createDiv({ cls: "config-sync-rule-spacer" });
    const capItems = this.capturePayload();
    const applyItems = this.applyPayload();

    const run = <T>(
      btn: ButtonComponent,
      other: ButtonComponent,
      verb: "Capturing" | "Applying",
      payload: T[],
      exec: (payload: T[], onProgress: ProgressFn) => Promise<GroupResult[] | null>
    ): void => {
      this.running = true;
      this.activeRun = { verb, done: 0, total: payload.length };
      btn.setDisabled(true);
      other.setDisabled(true);
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

    const capW = mkWrapped();
    if (this.activeRun?.verb === "Capturing") {
      capW.btn.setButtonText(runProgressLabel("Capturing", this.activeRun.done, this.activeRun.total));
      capW.btn.buttonEl.addClass("is-busy");
    } else {
      renderActionIcon(capW.btn.buttonEl, "capture");
      capW.btn.buttonEl.appendText(` Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
    }
    capW.btn.buttonEl.addClass("config-sync-btn-capture");
    capW.btn.setDisabled(this.running || capItems.length === 0);

    const applyW = mkWrapped();
    applyW.btn.setCta();
    if (this.activeRun?.verb === "Applying") {
      applyW.btn.setButtonText(runProgressLabel("Applying", this.activeRun.done, this.activeRun.total));
      applyW.btn.buttonEl.addClass("is-busy");
    } else {
      renderActionIcon(applyW.btn.buttonEl, "apply");
      applyW.btn.buttonEl.appendText(` Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
    }
    applyW.btn.setDisabled(this.running || applyItems.length === 0);

    capW.btn.onClick(() => run(capW.btn, applyW.btn, "Capturing", this.capturePayload(), (n, p) => this.host.captureItems(n, p)));
    applyW.btn.onClick(() => run(applyW.btn, capW.btn, "Applying", this.applyPayload(), (n, p) => this.host.applyItems(n, p)));
  }

  private renderRemoteMode(main: HTMLElement, remote: Remote): void {
    this.renderResultStrip(main);
    const check = this.host.remoteCheck(remote.name)?.check;
    const icon = this.remoteIcon(check);
    main.createDiv({
      cls: "config-sync-remote-head",
      text: `${remote.name} · captured ${isoAge(check?.remoteCapturedAt ?? null)} — ${icon.tip}`,
    });
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

  private async renderRemoteDetail(detail: HTMLElement, remote: Remote, check: RemoteCheck | undefined): Promise<void> {
    detail.empty();
    detail.createDiv({ cls: "config-sync-remote-comparing", text: "comparing…" });
    const gen = this.renderGen;
    let entries: RemoteDiffEntry[];
    let lockDiffers = false;
    try {
      const dd = await this.host.deepDiff(remote);
      entries = dd.entries;
      lockDiffers = dd.lockDiffers;
    } catch (e) {
      if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
      detail.empty();
      detail.createDiv({ cls: "config-sync-status-error", text: `cannot compare: ${(e as Error).message}` });
      return;
    }
    if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
    detail.empty();

    const changed = entries.filter((e) => hasChanges(e.changes));
    for (const cat of SCOPE_ORDER) {
      const inCat = changed.filter((e) => this.scopeOf(e.group) === cat);
      if (inCat.length === 0) continue;
      detail.createDiv({ cls: "config-sync-sect", text: SCOPE_LABELS[cat] });
      for (const e of inCat) this.renderRemoteDiffEntry(detail, e);
    }

    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";
    const directionText = pullAligned ? "Pull would bring these changes" : "Push would send these changes";

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.groups
      .filter((g) => !changedNames.has(g.name))
      .map((g) => this.host.displayName(g.name, g.label));
    const matched = matchNames.length;
    if (entries.length === 0) {
      detail.createDiv({
        cls: "config-sync-unchanged",
        text: lockDiffers
          ? "✓ contents match — remote has newer version info; Pull refreshes it"
          : "✓ remote matches the local store",
      });
    } else if (matched > 0) {
      const line = detail.createDiv({
        cls: "config-sync-unchanged",
        text: `✓ ${matched} more item${matched === 1 ? " matches" : "s match"} ▸ · ${directionText}`,
      });
      line.addEventListener("click", () => line.setText(`✓ ${matchNames.join(" · ")}`));
    } else {
      detail.createDiv({ cls: "config-sync-remote-summary", text: directionText });
    }

    // lockDiffers alone still gives Pull something to do (refresh the newer version info),
    // so it keeps the buttons live even when every file's contents match.
    this.renderRemoteButtons(detail, remote, pullAligned, entries.length === 0 && !lockDiffers);
  }

  private renderRemoteDiffEntry(detail: HTMLElement, e: RemoteDiffEntry): void {
    const row = detail.createDiv({ cls: "config-sync-report-row" });
    row.createSpan({ cls: "config-sync-rule-name", text: this.host.displayName(e.group, findGroupByName(this.groups, e.group)?.label) });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    if (e.changes.added.length > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${e.changes.added.length}` });
    if (e.changes.updated.length > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${e.changes.updated.length}` });
    if (e.changes.deleted.length > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${e.changes.deleted.length}` });
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

class ExcludeExtrasModal extends Modal {
  private checks = new Map<string, boolean>();

  constructor(app: App, private listLabel: string, private ids: string[], private onConfirm: (ids: string[]) => Promise<void>) {
    super(app);
    for (const id of ids) this.checks.set(id, true);
  }

  onOpen(): void {
    this.titleEl.setText("Exclude from this list (this device)");
    this.contentEl.createDiv({
      cls: "config-sync-expand-note",
      text: `${this.listLabel}: excluded plugins keep their own on/off state on this device — the shared list neither includes nor changes them.`,
    });
    const list = this.contentEl.createDiv();
    for (const id of this.ids) {
      const row = list.createDiv({ cls: "config-sync-exclude-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      cb.addEventListener("change", () => this.checks.set(id, cb.checked));
      row.createSpan({ text: id });
    }
    const bar = this.contentEl.createDiv({ cls: "config-sync-modal-buttons" });
    new ButtonComponent(bar).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(bar)
      .setButtonText("Exclude")
      .setCta()
      .onClick(() => {
        const picked = this.ids.filter((id) => this.checks.get(id) === true);
        this.close();
        void this.onConfirm(picked);
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
