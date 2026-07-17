import { App, ButtonComponent, ExtraButtonComponent, ItemView, Modal, WorkspaceLeaf, setIcon } from "obsidian";
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

const CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

// Session-remembered UI state: which scopes have their ✓ / ○ trailing lines flattened open.
const sessionUi = {
  insyncOpen: new Set<string>(),
  nosettingsOpen: new Set<string>(),
};

export interface SyncCenterHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
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
  private policy: Map<string, StateAction> = new Map();
  private sectionOpen: Set<SectionKind> = new Set();
  private selected: Set<string> = new Set();
  private directionOverride: Map<string, Direction> = new Map();
  private expandedItems: Set<string> = new Set();
  private renderGen = 0;
  private filter: PanelFilter = "all";
  private panelScope: { kind: "device"; cat: ItemCategory | "all" } | { kind: "remote"; name: string } = { kind: "device", cat: "all" };
  private search = "";
  private firstLoad = true;
  private lastRefreshedAt: number | null = null;
  private compact = false;
  private switcherOpen = false;
  private running = false;
  private lastRun: { title: string; tone: "local" | "transfer"; results: GroupResult[]; expanded: boolean } | null = null;

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
        if (leaf === this.leaf) void this.reload();
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
      this.render(this.renderGen);
    }
  }

  // Called by the plugin when awareness state changes while the view is open.
  notifyExternalChange(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    const gen = ++this.renderGen;
    const { groups, statuses, availability } = await this.host.computeStatuses();
    if (gen !== this.renderGen) return;
    this.groups = groups;
    this.statuses = new Map(statuses.map((s) => [s.group, s]));
    this.availability = new Map(Object.entries(availability));
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
    // Default pre-check seeds once per view lifetime, never on later refreshes.
    if (this.firstLoad) {
      this.firstLoad = false;
      for (const s of statuses) {
        if ((s.state === "local-changed" || s.state === "store-newer") && this.sectionOf(s.group) === "main") this.selected.add(s.group);
      }
    }
    this.lastRefreshedAt = Date.now();
    this.render(gen);
  }

  private availOf(name: string): Availability {
    return this.availability.get(name) ?? { kind: "enabled", drift: null, localVersion: null, storeVersion: null, anchor: "app" };
  }

  private sectionOf(name: string): SectionKind {
    return sectionForItem(this.availOf(name));
  }

  private rows(): StatusRow[] {
    const out: StatusRow[] = [];
    for (const group of this.groups) {
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    return out;
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
    this.renderBootstrapBanner(this.contentEl, gen);
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "config-sync-main" });
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

  // Fresh-device adopt banner (self-config model 定稿): shown when the store already holds a
  // captured configuration but this device has no groups yet. Fetched async into a placeholder.
  private renderBootstrapBanner(container: HTMLElement, gen: number): void {
    const host = container.createDiv();
    void this.host.bootstrapOffer().then((offer) => {
      if (offer === null || gen !== this.renderGen) return;
      const banner = host.createDiv({ cls: "config-sync-bootstrap" });
      banner.createSpan({ cls: "config-sync-bootstrap-icon", text: "⬇" });
      const textBox = banner.createDiv({ cls: "config-sync-bootstrap-text" });
      textBox.createDiv({ cls: "config-sync-bootstrap-title", text: "Found an existing configuration in the store" });
      const when = offer.capturedAt === null ? "" : ` · captured ${isoAge(offer.capturedAt)}`;
      textBox.createDiv({
        cls: "config-sync-bootstrap-sub",
        text: `${offer.itemCount} sync item${offer.itemCount === 1 ? "" : "s"}${when}. Adopt it to set up this device.`,
      });
      const adopt = banner.createEl("button", { cls: "mod-cta config-sync-bootstrap-adopt", text: "Adopt" });
      adopt.addEventListener("click", () => {
        adopt.disabled = true;
        adopt.setText("Adopting…");
        void this.host.adoptConfiguration().then((results) => {
          if (results !== null) this.setLastRun("Adopted", "local", results);
          this.notifyExternalChange(); // recompute: groups now exist → banner disappears
        });
      });
      const dismiss = banner.createSpan({ cls: "config-sync-bootstrap-dismiss", text: "✕" });
      dismiss.setAttribute("aria-label", "Dismiss for this session");
      dismiss.setAttribute("title", "Dismiss for this session");
      dismiss.addEventListener("click", () => {
        this.host.dismissBootstrap();
        banner.remove();
      });
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
      this.search = searchEl.value;
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
    container.createDiv({ cls: "config-sync-side-head", text: "This device ↔ store" });

    const deviceEntry = (cat: ItemCategory | "all", label: string, rows: StatusRow[]): void => {
      const active = this.panelScope.kind === "device" && this.panelScope.cat === cat;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      if (this.searching()) {
        // Hit counts must span the entry's full scope — every section (outdated/disabled/
        // not-installed included), not just mainRows() — so a match hiding in e.g. "Not
        // installed" still counts here. Bucket badges below stay main-section-only.
        const scopeRows = cat === "all" ? this.rows() : this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
        const hits = scopeRows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search)).length;
        item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${hits}` });
      } else {
        const c = this.presentedCounts(rows);
        if (c.up > 0) item.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
        if (c.down > 0) item.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
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
    for (const cat of CATEGORY_ORDER) {
      const inCat = this.mainRows().filter((r) => categoryForGroup(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, CATEGORY_LABELS[cat], inCat);
    }

    const remotes = this.host.remotes();
    if (remotes.length === 0) return;
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
      item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
      item.addEventListener("click", () => {
        this.panelScope = { kind: "remote", name: remote.name };
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
      sw.createSpan({ text: cat === "all" ? "All items" : CATEGORY_LABELS[cat] });
      const c = this.presentedCounts(this.scopedRows().filter((r) => this.sectionOf(r.group.name) === "main"));
      if (c.up > 0) sw.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) sw.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
      if (c.ok > 0) sw.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) sw.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
    } else {
      sw.createSpan({ text: this.panelScope.name });
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
      sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph });
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
      pills.createSpan({
        cls: "config-sync-pill is-up",
        text: `↑ ${up}`,
        attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` },
      });
    }
    if (down > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-down",
        text: `↓ ${down}`,
        attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` },
      });
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

  private setLastRun(title: string, tone: "local" | "transfer", results: GroupResult[] | null): void {
    if (results !== null) this.lastRun = { title, tone, results, expanded: false };
  }

  private renderResultStrip(main: HTMLElement): void {
    const run = this.lastRun;
    if (run === null) return;
    const strip = main.createDiv({ cls: `config-sync-strip${run.tone === "transfer" ? " is-transfer" : ""}` });
    const head = strip.createDiv({ cls: "config-sync-strip-head" });
    head.createSpan({ cls: "config-sync-strip-check", text: "✓" });
    head.createSpan({ cls: "config-sync-strip-title", text: run.title });
    renderReportPills(head, run.results);
    const toggle = head.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
    toggle.addEventListener("click", () => {
      run.expanded = !run.expanded;
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

  private scopeKey(): string {
    return this.panelScope.kind === "device" ? this.panelScope.cat : `remote:${this.panelScope.name}`;
  }

  private searching(): boolean {
    return this.search.trim() !== "";
  }

  private scopedRows(): StatusRow[] {
    if (this.searching()) return this.rows();
    if (this.panelScope.kind !== "device" || this.panelScope.cat === "all") return this.rows();
    const cat = this.panelScope.cat;
    return this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    this.renderResultStrip(main);
    const scoped = this.scopedRows();
    const mainRows = scoped.filter((r) => this.sectionOf(r.group.name) === "main");
    const sections: Record<Exclude<SectionKind, "main">, StatusRow[]> = { outdated: [], disabled: [], "not-installed": [] };
    for (const r of scoped) {
      const s = this.sectionOf(r.group.name);
      if (s !== "main") sections[s].push(r);
    }
    // While searching, the pills count the MATCHED set (定稿): the All pill keeps the
    // unfiltered total as "n / m".
    const pillRows = this.searching()
      ? mainRows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search))
      : mainRows;
    const counts = this.presentedCounts(pillRows);

    const bar = main.createDiv({ cls: "config-sync-mainbar" });
    const defs: { key: PanelFilter; label: string }[] = [
      { key: "all", label: this.searching() ? `All ${pillRows.length} / ${mainRows.length}` : `All ${mainRows.length}` },
      { key: "capture", label: `To capture ${counts.up}` },
      { key: "apply", label: `To apply ${counts.down}` },
      { key: "ok", label: `In sync ${counts.ok}` },
      { key: "none", label: `No settings yet ${counts.none}` },
    ];
    for (const d of defs) {
      const pill = bar.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, text: d.label });
      pill.addEventListener("click", () => {
        this.filter = d.key;
        this.render(this.renderGen);
      });
    }
    if (this.compact) {
      const searchEl = bar.createEl("input", {
        type: "search",
        cls: "config-sync-mainbar-search",
        attr: { placeholder: "Filter by name…" },
      });
      searchEl.value = this.search;
      searchEl.addEventListener("input", () => {
        this.search = searchEl.value;
        this.renderListInto(listHost, mainRows); // re-render only the list; keeps the input focused
        this.refreshGlobalSelectAll(selectAll, mainRows); // resync tri-state against the new search
      });
    }
    const selectAll = bar.createEl("input", { type: "checkbox", cls: "config-sync-selectall", attr: { "aria-label": "Select all visible items" } });

    const listHost = main.createDiv();
    this.renderListInto(listHost, mainRows);
    this.wireGlobalSelectAll(selectAll, mainRows);

    this.renderSection(main, "outdated", sections.outdated);
    this.renderSection(main, "disabled", sections.disabled);
    this.renderSection(main, "not-installed", sections["not-installed"]);

    this.renderActionBar(main);
  }

  private visibleRows(scoped: StatusRow[]): StatusRow[] {
    return scoped.filter((r) => visibleUnderFilter(this.presState(r), this.filter) && matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search));
  }

  private renderListInto(listHost: HTMLElement, scoped: StatusRow[]): void {
    listHost.empty();
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
      for (const r of active) this.renderItemRow(card, r);
      this.renderTrailingLine(card, insync, sessionUi.insyncOpen, (n, open) => insyncLineText(n, open));
      this.renderTrailingLine(card, nosettings, sessionUi.nosettingsOpen, (n, open) => nosettingsLineText(n, open));
    } else {
      for (const r of visible) this.renderItemRow(card, r);
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
    row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
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
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
    });
  }

  private stateIcon(state: GroupState): { glyph: string; cls: string; tip: string } {
    switch (state) {
      case "local-changed":
        return { glyph: "↑", cls: "is-up", tip: "changed on this device (likely)" };
      case "store-newer":
        return { glyph: "↓", cls: "is-down", tip: "store is newer (likely)" };
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
        detail.createDiv({ cls: "config-sync-expand-note", text: "identical to the store — applying installs the plugin" });
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
        detail.createDiv({ cls: "config-sync-expand-note", text: "no settings to apply — installs the plugin only" });
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
    const seg = detail.createDiv({ cls: "config-sync-seg" });
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
        text: label,
        attr: { "aria-label": aria },
      });
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
    segBtn("capture", "↑ Capture", "Capture this (keep local)");
    segBtn("apply", "↓ Apply store", "Apply store version (overwrites local)");
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
            btn.setButtonText(`${verb} ${done}/${total}…`);
            btn.buttonEl.setAttribute("aria-label", current);
            setStatus(current, phase ?? (verb === "Capturing" ? "capturing…" : "applying…"));
            if (fill !== null) fill.style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
          });
          this.setLastRun(verb === "Capturing" ? "Captured" : "Applied", "local", results);
        } finally {
          if (slowTimer !== null) window.clearTimeout(slowTimer);
          statusEl.remove();
          barEl?.removeClass("is-active");
          this.running = false;
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
    capW.btn.setButtonText(`↑ Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
    capW.btn.buttonEl.addClass("config-sync-btn-capture");
    capW.btn.setDisabled(this.running || capItems.length === 0);

    const applyW = mkWrapped();
    applyW.btn.setCta();
    applyW.btn.setButtonText(`↓ Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
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

  private remoteIcon(check: RemoteCheck | undefined): { glyph: string; cls: string; tip: string } {
    const state = check?.state ?? "unknown";
    switch (state) {
      case "remote-newer":
        return { glyph: "↓", cls: "is-pull", tip: "remote captured later — Pull would update your store" };
      case "remote-older":
        return { glyph: "↑", cls: "is-push", tip: "remote is older — Push would update the remote" };
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
    for (const cat of CATEGORY_ORDER) {
      const inCat = changed.filter((e) => categoryForGroup(e.group) === cat);
      if (inCat.length === 0) continue;
      detail.createDiv({ cls: "config-sync-sect", text: CATEGORY_LABELS[cat] });
      for (const e of inCat) this.renderRemoteDiffEntry(detail, e);
    }

    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";
    const directionText = pullAligned ? "Pull would bring these changes" : "Push would send these changes";

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.groups.filter((g) => !changedNames.has(g.name)).map((g) => g.name);
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

    this.renderRemoteButtons(detail, remote, pullAligned, entries.length === 0);
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
    pull.setButtonText(`↓ Pull from ${remote.name}`);
    pull.buttonEl.addClass("config-sync-remote-btn", "is-pull");
    if (noChanges) pull.buttonEl.addClass("is-dimmed");
    else if (pullAligned) pull.buttonEl.addClass("is-primary");
    else {
      pull.buttonEl.addClass("is-dimmed");
      pull.buttonEl.setAttribute("aria-label", "Pull would overwrite your newer local store");
    }
    pull.onClick(async () => {
      this.setLastRun(`Pulled from ${remote.name}`, "transfer", await this.host.pullFrom(remote));
      await this.reload();
    });

    const push = new ButtonComponent(bar);
    push.setButtonText(`↑ Push to ${remote.name}`);
    push.buttonEl.addClass("config-sync-remote-btn", "is-push");
    if (noChanges) push.buttonEl.addClass("is-dimmed");
    else if (!pullAligned) push.buttonEl.addClass("is-primary");
    else {
      push.buttonEl.addClass("is-dimmed");
      push.buttonEl.setAttribute("aria-label", "Push would overwrite the newer remote");
    }
    push.onClick(async () => {
      this.setLastRun(`Pushed to ${remote.name}`, "transfer", await this.host.pushTo(remote));
      await this.reload();
    });
  }
}

// Confirmation for the divergence shortcut: pre-checked list of this device's extra ids;
// confirming adds the checked ones to the device-local exceptions.
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
